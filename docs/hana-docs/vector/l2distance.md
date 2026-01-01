L2DISTANCE Function (Vector)
============================

Computes the L2 distance of two vectors.

Syntax
------

    L2DISTANCE(<vector1>, <vector2>)

Syntax Elements
---------------

<vector1>

Specifies the first vector.

<vector2>

Specifies the second vector.

Description
-----------

Computes the L2 distance in space of <vector1> and <vector2>. Both vectors must have the same dimension.

The result is a DOUBLE number greater or equal to 0. The greater the result, the greater the distance between the vectors. The smaller the result, the smaller the distance between the vectors.

For two vectors u and v, the L2 distance is mathematically defined as follows:

![](https://help.sap.com/doc/c40cab369db246f1a17feea1c031ddc1/2025_4_QRC/en-US/loio0fccde0772814cdab55055da10f3f866_LowRes.svg)

Example
-------

The following example returns 5.0:

    SELECT L2DISTANCE(
        TO_REAL_VECTOR('[2, 3, 5]'),
        TO_REAL_VECTOR('[6, 6, 5]'))
    FROM DUMMY;

The following example returns 5.0:

    SELECT L2DISTANCE(
        TO_HALF_VECTOR('[2, 3, 5]'),
        TO_HALF_VECTOR('[6, 6, 5]'))
    FROM DUMMY;

Related Information